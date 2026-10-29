const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/gnomeShortcut");
const originalLoad = Module._load;

// `xkbcomp -xkb :0 -` on Ubuntu 26.04's stock keymap (xkb-data 2.46), trimmed to the
// F13-F24 keys: they carry XF86 keysyms, and F19 and F24 have no entry at all.
const STOCK_KEYMAP = [
  'xkb_symbols "pc+us+inet(evdev)" {',
  "    key <FK13> {         [       XF86Tools ] };",
  "    key <FK14> {         [     XF86Launch5 ] };",
  "    key <FK15> {         [     XF86Launch6 ] };",
  "    key <FK16> {         [     XF86Launch7 ] };",
  "    key <FK17> {         [     XF86Launch8 ] };",
  "    key <FK18> {         [     XF86Launch9 ] };",
  "    key <FK20> {         [ XF86AudioMicMute ] };",
  "    key <FK21> {         [ XF86TouchpadToggle ] };",
  "    key <FK22> {         [  XF86TouchpadOn ] };",
  "    key <FK23> {",
  '        type= "PC_SHIFT_SUPER_LEVEL2",',
  "        symbols[Group1]= [ XF86TouchpadOff,   XF86Assistant ]",
  "    };",
  "};",
].join("\n");

// The same keys with the "Use F13-F24 as usual function keys" option (fkeys:basic_13-24).
const FKEYS_KEYMAP = [
  'xkb_symbols "pc+us+inet(evdev)+fkeys(basic_13-24)" {',
  ...Array.from({ length: 12 }, (_, i) => `    key <FK${13 + i}> {         [ F${13 + i} ] };`),
  "};",
].join("\n");

// `gsettings list-recursively` on the same machine, trimmed to the bindings that matter.
const MEDIA_KEYS = [
  "org.gnome.settings-daemon.plugins.media-keys control-center-static ['XF86Tools']",
  "org.gnome.settings-daemon.plugins.media-keys custom-keybindings @as []",
  "org.gnome.settings-daemon.plugins.media-keys mic-mute-static ['XF86AudioMicMute']",
  "org.gnome.settings-daemon.plugins.media-keys screensaver ['<Super>l']",
  "org.gnome.settings-daemon.plugins.media-keys touchpad-off-static ['XF86TouchpadOff']",
  "org.gnome.settings-daemon.plugins.media-keys touchpad-on-static ['XF86TouchpadOn']",
  "org.gnome.settings-daemon.plugins.media-keys touchpad-toggle-static ['XF86TouchpadToggle', '<Ctrl><Super>XF86TouchpadToggle']",
].join("\n");

// customBindings: other custom shortcuts already in gsettings, by path.
function loadManager({ keymap = STOCK_KEYMAP, customBindings = {} } = {}) {
  const calls = [];
  const paths = Object.keys(customBindings);
  const execFileSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === "xkbcomp") {
      if (keymap instanceof Error) throw keymap;
      return keymap;
    }
    if (args[0] === "list-recursively") return MEDIA_KEYS;
    if (args[0] === "get" && args[2] === "custom-keybindings") {
      return paths.length ? `['${paths.join("', '")}']` : "@as []";
    }
    if (args[0] === "get" && args[2] === "binding") {
      return `'${customBindings[args[1].slice(args[1].indexOf(":") + 1)]}'`;
    }
    return "";
  };
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process") return { ...childProcess, execFileSync };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const GnomeShortcutManager = require(modulePath);
    return { manager: new GnomeShortcutManager(), calls };
  } finally {
    Module._load = originalLoad;
  }
}

const writtenBinding = (calls) =>
  calls.find(
    ([command, verb, , key]) => command === "gsettings" && verb === "set" && key === "binding"
  )?.[4];
const readKeymap = (calls) => calls.some(([command]) => command === "xkbcomp");

const originalEnv = {
  XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
  DISPLAY: process.env.DISPLAY,
};
test.before(() => {
  process.env.XDG_CURRENT_DESKTOP = "ubuntu:GNOME";
  process.env.DISPLAY = ":0";
});
test.after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete require.cache[modulePath];
});

test("an F13-F24 key binds the keysym the stock keymap gives it", async () => {
  const { manager, calls } = loadManager();

  assert.equal(await manager.registerKeybinding("F16", "dictation"), true);
  assert.equal(writtenBinding(calls), "XF86Launch7");
});

test("modifiers stay on a remapped F13-F24 key", async () => {
  const { manager, calls } = loadManager();

  assert.equal(await manager.registerKeybinding("<Control><Shift>F15", "meeting"), true);
  assert.equal(writtenBinding(calls), "<Control><Shift>XF86Launch6");
});

test("a keymap that carries F13-F24 keysyms keeps the F-key name", async () => {
  const { manager, calls } = loadManager({ keymap: FKEYS_KEYMAP });

  assert.equal(await manager.registerKeybinding("F16", "dictation"), true);
  assert.equal(writtenBinding(calls), "F16");
});

test("a key with no keysym is refused before anything is written", async () => {
  const { manager, calls } = loadManager();

  assert.equal(await manager.registerKeybinding("F19", "dictation"), "keysym_missing");
  assert.equal(await manager.registerKeybinding("F24", "dictation"), "keysym_missing");
  assert.equal(writtenBinding(calls), undefined);
});

test("a keysym GNOME's media keys already grab is refused", async () => {
  const { manager, calls } = loadManager();

  // F13 sends XF86Tools, which opens Settings; F20 sends XF86AudioMicMute.
  assert.equal(await manager.registerKeybinding("F13", "dictation"), "keysym_reserved");
  assert.equal(await manager.registerKeybinding("F20", "dictation"), "keysym_reserved");
  // F23's multi-line entry sends XF86TouchpadOff first.
  assert.equal(await manager.registerKeybinding("F23", "dictation"), "keysym_reserved");
  // <Ctrl> in a gsd binding is <Control>, so this exact accelerator is taken too.
  assert.equal(
    await manager.registerKeybinding("<Control><Super>F21", "dictation"),
    "keysym_reserved"
  );
  assert.equal(writtenBinding(calls), undefined);
});

test("the same keysym with other modifiers is free", async () => {
  const { manager, calls } = loadManager();

  assert.equal(await manager.registerKeybinding("<Control>F13", "dictation"), true);
  assert.equal(writtenBinding(calls), "<Control>XF86Tools");
});

test("a custom shortcut on the keysym the key sends is a conflict", async () => {
  const other = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
  const { manager, calls } = loadManager({
    customBindings: { [other]: "XF86Launch7" },
  });

  assert.equal(await manager.registerKeybinding("F16", "dictation"), false);
  assert.equal(writtenBinding(calls), undefined);
});

test("a custom shortcut written with <Ctrl> conflicts with <Control>", async () => {
  const other = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
  const { manager, calls } = loadManager({ customBindings: { [other]: "<Ctrl>r" } });

  assert.equal(await manager.registerKeybinding("<Control>r", "dictation"), false);
  assert.equal(writtenBinding(calls), undefined);
});

test("only a key's symbols list is read, never another field's list", async () => {
  const keymap = [
    "xkb_symbols {",
    "    key <FK16> {",
    "        actions[Group1]= [ SetMods(modifiers=Shift) ],",
    "        symbols[Group1]= [ XF86Launch7 ]",
    "    };",
    "};",
  ].join("\n");
  const { manager, calls } = loadManager({ keymap });

  assert.equal(await manager.registerKeybinding("F16", "dictation"), true);
  assert.equal(writtenBinding(calls), "XF86Launch7");
});

test("without a DISPLAY the keymap isn't read and the F-key name is kept", async () => {
  process.env.DISPLAY = "";
  try {
    const { manager, calls } = loadManager();

    assert.equal(await manager.registerKeybinding("F16", "dictation"), true);
    assert.equal(writtenBinding(calls), "F16");
    assert.equal(readKeymap(calls), false);
  } finally {
    process.env.DISPLAY = ":0";
  }
});

test("an unreadable keymap keeps the F-key name", async () => {
  for (const keymap of [new Error("spawn xkbcomp ENOENT"), ""]) {
    const { manager, calls } = loadManager({ keymap });

    assert.equal(await manager.registerKeybinding("F16", "dictation"), true);
    assert.equal(writtenBinding(calls), "F16");
  }
});

test("keys outside F13-F24 never read the keymap", async () => {
  const { manager, calls } = loadManager();

  assert.equal(await manager.registerKeybinding("F8", "dictation"), true);
  assert.equal(await manager.registerKeybinding("<Alt>F1", "meeting"), true);
  assert.equal(readKeymap(calls), false);
});

test("Hold hands the portal the keysym", async () => {
  const { manager } = loadManager();
  const triggers = [];
  manager.globalShortcutsPortal = {
    registerKeybinding: async (trigger) => {
      triggers.push(trigger);
      return true;
    },
    unregisterKeybinding: async () => {},
  };

  assert.equal(await manager.registerPushToTalk("Control+F16", () => {}), true);
  assert.deepEqual(triggers, ["CTRL+XF86Launch7"]);
});

test("Hold reports each portal down and up for the debug log before acting on it", async () => {
  const { manager } = loadManager();
  let portalCallback;
  manager.globalShortcutsPortal = {
    registerKeybinding: async (_trigger, callback) => {
      portalCallback = callback;
      return true;
    },
    unregisterKeybinding: async () => {},
  };
  const order = [];
  manager.onHotkeyEvent = (slotName, action) => order.push(`log:${slotName}:${action}`);

  await manager.registerPushToTalk("Control+F16", (_hotkey, phase) => order.push(phase));
  portalCallback(undefined, "down");
  portalCallback(undefined, "up");

  assert.deepEqual(order, ["log:dictation:down", "down", "log:dictation:up", "up"]);
});

test("Hold falling back to Tap binds the keysym and reads the keymap once", async () => {
  const { manager, calls } = loadManager();
  manager.globalShortcutsPortal = {
    registerKeybinding: async () => false,
    unregisterKeybinding: async () => {},
  };

  assert.equal(await manager.registerPushToTalk("F16", () => {}), false);
  assert.equal(writtenBinding(calls), "XF86Launch7");
  assert.equal(calls.filter(([command]) => command === "xkbcomp").length, 1);
});

test("Hold refuses a key GNOME can't grab and keeps the Tap binding", async () => {
  const { manager, calls } = loadManager();
  manager.globalShortcutsPortal = {
    registerKeybinding: async () => assert.fail("the portal is never asked"),
    unregisterKeybinding: async () => {},
  };

  assert.equal(await manager.registerPushToTalk("F19", () => {}), "keysym_missing");
  assert.equal(await manager.registerPushToTalk("F13", () => {}), "keysym_reserved");
  const gsettingsWrites = calls.filter(
    ([command, verb]) => command === "gsettings" && (verb === "set" || verb === "reset")
  );
  assert.deepEqual(gsettingsWrites, []);
});
