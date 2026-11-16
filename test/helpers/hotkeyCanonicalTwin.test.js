const test = require("node:test");
const assert = require("node:assert/strict");

const { canonicalizeHotkey, sameHotkey } = require("../../src/helpers/hotkeyCanonical.js");

// Main had no canonicalizer at all, so a per-row lookup keyed on the
// renderer's answer would have missed whenever the stored spelling differed
// from the canonical one. These two implementations are now the single
// comparison contract, and this table is what keeps them honest: if they ever
// drift, a row silently falls back to "Use app setting" with no error.
const ALIAS_TABLE = [
  "Control+Shift+Space",
  "Ctrl+Shift+Space",
  "CommandOrControl+Shift+Space",
  "CmdOrCtrl+Shift+Space",
  "Shift+Control+Space",
  "Control+Alt+Shift",
  "Alt+Control+Shift",
  "Control+,",
  "Control+.",
  "Ctrl+F8",
  "ctrl+f8",
  "Command+K",
  "Cmd+K",
  "Super+K",
  "Meta+K",
  "Win+K",
  "Option+R",
  "Alt+R",
  "RightControl",
  "RightOption",
  "LeftShift",
  "GLOBE",
  "Fn",
  "MouseButton4",
  "Escape",
  "Esc",
  "ArrowLeft",
  "PgUp",
  "F12",
  "A",
  "a",
  "",
];

const PLATFORMS = ["win32", "darwin", "linux"];

test("the main twin matches the renderer normalizeHotkey on every alias", async () => {
  const { normalizeHotkey } = await import("../../src/utils/hotkeyValidator.ts");

  for (const platform of PLATFORMS) {
    for (const hotkey of ALIAS_TABLE) {
      assert.equal(
        canonicalizeHotkey(hotkey, platform),
        normalizeHotkey(hotkey, platform),
        `"${hotkey}" on ${platform}`
      );
    }
  }
});

test("spellings of one chord canonicalize together", () => {
  const space = ["Control+Shift+Space", "Ctrl+Shift+Space", "Shift+Control+Space"];
  for (const spelling of space) {
    assert.equal(canonicalizeHotkey(spelling, "win32"), "Control+Shift+Space", spelling);
  }
  assert.equal(canonicalizeHotkey("CommandOrControl+Shift+Space", "win32"), "Control+Shift+Space");
  assert.ok(sameHotkey("Ctrl+Shift+Space", "Shift+Control+Space", "win32"));
  assert.ok(!sameHotkey("Control+Shift+Space", "Control+Alt+Shift", "win32"));
});

// Canonical form is platform-dependent, which is exactly why stored rows keep
// the user's original spelling — a canonical-at-write profile authored on
// macOS would lose its modes when read on Windows.
test("CommandOrControl and Super resolve per platform, so storage must not be canonical", () => {
  assert.equal(canonicalizeHotkey("CommandOrControl+K", "darwin"), "Command+K");
  assert.equal(canonicalizeHotkey("CommandOrControl+K", "win32"), "Control+K");
  assert.equal(canonicalizeHotkey("Super+K", "darwin"), "Command+K");
  assert.equal(canonicalizeHotkey("Super+K", "linux"), "Super+K");
});

test("the comma key survives canonicalization", () => {
  assert.equal(canonicalizeHotkey("Control+,", "win32"), "Control+,");
  assert.ok(sameHotkey("Ctrl+,", "Control+,", "win32"));
  assert.ok(!sameHotkey("Control+,", "Control+.", "win32"));
});

test("a missing or malformed hotkey canonicalizes to empty rather than throwing", () => {
  assert.equal(canonicalizeHotkey("", "win32"), "");
  assert.equal(canonicalizeHotkey(null, "win32"), "");
  assert.equal(canonicalizeHotkey(undefined, "win32"), "");
  assert.equal(canonicalizeHotkey(42, "win32"), "");
});
