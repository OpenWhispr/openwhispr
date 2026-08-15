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

test("raw punctuation strings are rejected by the GNOME validator", () => {
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>,"), false);
  assert.equal(GnomeShortcutManager.isValidShortcut("<Control>plus"), true);
});
