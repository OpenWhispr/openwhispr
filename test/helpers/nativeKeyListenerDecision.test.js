const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/hotkeyManager.js");

// usingNativeShortcut = true  -> a compositor (GNOME/KDE/Hyprland) owns the hotkey
// usingNativeShortcut = false -> plain X11 / Windows / macOS (no compositor shortcut)

test("issue #864: compositor + tap + modifier-only does NOT start the native listener", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("Control+Super", "tap", true), false);
});

test("compositor + tap + normal key does NOT start the native listener", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("F8", "tap", true), false);
});

test("compositor + tap + right-side modifier does NOT start the native listener", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("RightControl", "tap", true), false);
});

test("compositor + push KEEPS the native listener (push-to-talk preserved)", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("Control+Super", "push", true), true);
  assert.equal(shouldUseNativeKeyListener("F8", "push", true), true);
});

test("no compositor + tap + modifier-only still starts the listener (X11 unchanged)", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("Control+Super", "tap", false), true);
});

test("no compositor + tap + right-side modifier still starts the listener", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("RightControl", "tap", false), true);
});

test("no compositor + tap + normal key does not start the listener", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("F8", "tap", false), false);
});

test("no compositor + push always starts the listener", async () => {
  const { shouldUseNativeKeyListener } = await load();
  assert.equal(shouldUseNativeKeyListener("F8", "push", false), true);
});

test("GLOBE / Fn / empty / null never start the listener, any mode or compositor", async () => {
  const { shouldUseNativeKeyListener } = await load();
  for (const usingNative of [true, false]) {
    for (const mode of ["tap", "push"]) {
      assert.equal(shouldUseNativeKeyListener("GLOBE", mode, usingNative), false);
      assert.equal(shouldUseNativeKeyListener("Fn", mode, usingNative), false);
      assert.equal(shouldUseNativeKeyListener("", mode, usingNative), false);
      assert.equal(shouldUseNativeKeyListener(null, mode, usingNative), false);
    }
  }
});
