const test = require("node:test");
const assert = require("node:assert/strict");

// Safety tests for the Linux DE-native hotkey converters. The validator now
// allows right-side modifiers on Linux, so the GNOME/KDE/Hyprland backends must
// never silently degrade a side-specific combo into a plain-key binding — that
// would make e.g. "RightAlt+Space" toggle dictation on every Space press.

const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut.js");
const HyprlandShortcutManager = require("../../src/helpers/hyprlandShortcut.js");
const KDEShortcutManager = require("../../src/helpers/kdeShortcut.js");

test("GNOME refuses side-specific modifier combos instead of binding the bare key", () => {
  // A right-side modifier as part of a combo must not degrade to plain Space.
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("RightAlt+Space"), "");

  // A bare right-side modifier trigger cannot be bound by GNOME custom shortcuts.
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("RightAlt"), "");
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("RightControl"), "");

  // Left-side specific tokens are refused the same way.
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("LeftControl+K"), "");

  // Ordinary combos keep working unchanged.
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Alt+Space"), "<Alt>space");
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("Control+Shift+K"), "<Control><Shift>k");
  assert.equal(GnomeShortcutManager.convertToGnomeFormat("F8"), "F8");
});

test("Hyprland maps right-side modifiers to XKB side keys, refusing ambiguous combos", () => {
  // Modifier-only right-side hotkey → standalone XKB side key bind.
  const rightAlt = HyprlandShortcutManager.convertToHyprlandFormat("RightAlt");
  assert.deepEqual(rightAlt, { mods: "", key: "Alt_R", bindKey: ", Alt_R" });

  // Compound with a side-specific modifier can't be expressed faithfully → refuse.
  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("RightAlt+Space"), null);
  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("LeftControl+K"), null);

  // Side-specific modifier as the trailing trigger of an otherwise-generic combo
  // keeps the side specificity (CTRL + right Alt).
  const ctrlRightAlt = HyprlandShortcutManager.convertToHyprlandFormat("Control+RightAlt");
  assert.equal(ctrlRightAlt.bindKey, "CTRL, Alt_R");

  // Existing conversions are unchanged.
  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("Alt+Space").bindKey, "ALT, Space");
  assert.equal(
    HyprlandShortcutManager.convertToHyprlandFormat("Control+Super").bindKey,
    "CTRL, Super_L"
  );
});

test("KDE refuses side-specific modifier tokens cleanly (Qt key codes are side-agnostic)", () => {
  // "RightAlt" isn't a Qt modifier or Qt key → conversion fails cleanly.
  assert.equal(KDEShortcutManager.convertToQtKeyCode("RightAlt"), null);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("RightAlt+Space"), null);

  // Ordinary combos still convert.
  assert.equal(typeof KDEShortcutManager.convertToQtKeyCode("Control+Shift+K"), "number");
});
