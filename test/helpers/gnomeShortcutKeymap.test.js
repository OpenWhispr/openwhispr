const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/gnomeShortcut");
const originalLoad = Module._load;

// `xmodmap -pke` for X keycodes 191-202 (F13-F24) on Ubuntu 26.04's stock keymap
// (xkb-data 2.46): the keys carry XF86 keysyms, F19 and F24 none at all.
const STOCK_KEYMAP = [
  "keycode  74 = F8 F8 F8 F8 F8 F8 XF86Switch_VT_8",
  "keycode 191 = XF86Tools NoSymbol XF86Tools",
  "keycode 192 = XF86Launch5 NoSymbol XF86Launch5",
  "keycode 193 = XF86Launch6 NoSymbol XF86Launch6",
  "keycode 194 = XF86Launch7 NoSymbol XF86Launch7",
  "keycode 195 = XF86Launch8 NoSymbol XF86Launch8",
  "keycode 196 = XF86Launch9 NoSymbol XF86Launch9",
  "keycode 197 =",
  "keycode 198 = XF86AudioMicMute NoSymbol XF86AudioMicMute",
  "keycode 199 = XF86TouchpadToggle NoSymbol XF86TouchpadToggle",
  "keycode 200 = XF86TouchpadOn NoSymbol XF86TouchpadOn",
  "keycode 201 = XF86TouchpadOff XF86Assistant XF86TouchpadOff XF86Assistant",
  "keycode 202 =",
].join("\n");

// The same keys with the "Use F13-F24 as usual function keys" option (fkeys:basic_13-24).
const FKEYS_KEYMAP = Array.from(
  { length: 12 },
  (_, i) => `keycode ${191 + i} = F${13 + i} NoSymbol F${13 + i}`
).join("\n");

// `gsettings list-recursively` on the same machine, trimmed to the bindings that matter.
const MEDIA_KEYS = [
  "org.gnome.settings-daemon.plugins.media-keys control-center-static ['XF86Tools']",
  "org.gnome.settings-daemon.plugins.media-keys custom-keybindings @as []",
  "org.gnome.settings-daemon.plugins.media-keys mic-mute-static ['XF86AudioMicMute']",
  "org.gnome.settings-daemon.plugins.media-keys screensaver ['<Super>l']",
  "org.gnome.settings-daemon.plugins.media-keys touchpad-toggle-static ['XF86TouchpadToggle', '<Ctrl><Super>XF86TouchpadToggle']",
].join("\n");

function loadManager({ keymap = STOCK_KEYMAP } = {}) {
  const calls = [];
  const execFileSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === "xmodmap") {
      if (keymap instanceof Error) throw keymap;
      return keymap;
    }
    if (args[0] === "list-recursively") return MEDIA_KEYS;
    if (args[0] === "get" && args[2] === "custom-keybindings") return "@as []";
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
  calls.find(([command, verb, , key]) => command === "gsettings" && verb === "set" && key === "binding")?.[4];
const ranXmodmap = (calls) => calls.some(([command]) => command === "xmodmap");

const originalDesktop = process.env.XDG_CURRENT_DESKTOP;
test.before(() => {
  process.env.XDG_CURRENT_DESKTOP = "ubuntu:GNOME";
});
test.after(() => {
  if (originalDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
  else process.env.XDG_CURRENT_DESKTOP = originalDesktop;
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

test("an unreadable keymap keeps the F-key name", async () => {
  const { manager, calls } = loadManager({ keymap: new Error("spawn xmodmap ENOENT") });

  assert.equal(await manager.registerKeybinding("F16", "dictation"), true);
  assert.equal(writtenBinding(calls), "F16");
});

test("keys outside F13-F24 never read the keymap", async () => {
  const { manager, calls } = loadManager();

  assert.equal(await manager.registerKeybinding("F8", "dictation"), true);
  assert.equal(await manager.registerKeybinding("<Alt>F1", "meeting"), true);
  assert.equal(ranXmodmap(calls), false);
});

test("Hold hands the portal the keysym, and refuses a key GNOME can't grab", async () => {
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
  assert.equal(await manager.registerPushToTalk("F19", () => {}), "keysym_missing");
  assert.equal(await manager.registerPushToTalk("F13", () => {}), "keysym_reserved");
  assert.deepEqual(triggers, ["CTRL+XF86Launch7"]);
});
