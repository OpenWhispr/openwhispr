const test = require("node:test");
const assert = require("node:assert/strict");

const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");

test("letter and function-key shortcuts still convert", () => {
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Alt+R"), "<Alt>r");
  assert.equal(GnomeShortcutManager.isValidShortcut("<Alt>r"), true);
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("F8"), "F8");
  assert.equal(GnomeShortcutManager.isValidShortcut("F8"), true);
});

test("punctuation accelerators map to X11 keysyms", () => {
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Control+,"), "<Control>comma");
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>comma"), true);

  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Alt+."), "<Alt>period");
  assert.equal(GnomeShortcutManager.isValidShortcut("<Alt>period"), true);

  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Control+/"), "<Control>slash");
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>slash"), true);

  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Control+-"), "<Control>minus");
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>minus"), true);

  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Control+Plus"), "<Control>plus");
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>plus"), true);
});

test("UI-emitted shifted punctuation consumes Shift and uses the resulting X11 keysym", () => {
  const shiftedPunctuationCases = [
    ["Control+Shift+`", "<Control>asciitilde"],
    ["Control+Shift+1", "<Control>exclam"],
    ["Control+Shift+2", "<Control>at"],
    ["Control+Shift+3", "<Control>numbersign"],
    ["Control+Shift+4", "<Control>dollar"],
    ["Control+Shift+5", "<Control>percent"],
    ["Control+Shift+6", "<Control>asciicircum"],
    ["Control+Shift+7", "<Control>ampersand"],
    ["Control+Shift+8", "<Control>asterisk"],
    ["Control+Shift+9", "<Control>parenleft"],
    ["Control+Shift+0", "<Control>parenright"],
    ["Control+Shift+-", "<Control>underscore"],
    ["Control+Shift+=", "<Control>plus"],
    ["Control+Shift+[", "<Control>braceleft"],
    ["Control+Shift+]", "<Control>braceright"],
    ["Control+Shift+\\", "<Control>bar"],
    ["Control+Shift+;", "<Control>colon"],
    ["Control+Shift+'", "<Control>quotedbl"],
    ["Control+Shift+,", "<Control>less"],
    ["Control+Shift+.", "<Control>greater"],
    ["Control+Shift+/", "<Control>question"],
  ];

  for (const [hotkey, expected] of shiftedPunctuationCases) {
    assert.equal(GnomeShortcutManager.convertToGnomeFormat(hotkey), expected, hotkey);
    assert.equal(GnomeShortcutManager.isValidShortcut(expected), true, expected);
  }
});

test("raw punctuation strings are rejected by the GNOME validator", () => {
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>,"), false);
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>plus"), true);
});

test("portal shortcuts use the XDG modifier syntax", () => {
  assert.equal(
    GnomeShortcutManager.convertToPortalFormat("Control+Shift+Space"),
    "CTRL+SHIFT+space"
  );
  assert.equal(GnomeShortcutManager.convertToPortalFormat("Super+Alt+F8"), "LOGO+ALT+F8");
  assert.equal(GnomeShortcutManager.convertToPortalFormat("Control+Shift+`"), "CTRL+SHIFT+grave");
  assert.equal(GnomeShortcutManager.convertToPortalFormat("Control+Super"), "");
});

test("failed portal registration restores the working GNOME tap binding", async () => {
  const manager = new GnomeShortcutManager();
  const registrations = [];
  manager.unregisterKeybinding = async () => true;
  manager.registerKeybinding = async (shortcut) => {
    registrations.push(shortcut);
    return true;
  };
  manager.globalShortcutsPortal.registerKeybinding = async () => false;

  assert.equal(await manager.registerPushToTalk("Alt+R", () => undefined), false);
  assert.deepEqual(registrations, ["<Alt>r"]);
});
