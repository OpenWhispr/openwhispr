const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/cancelHotkey.js");

test("registers the configured cancel hotkey without a fallback", async () => {
  const { registerRecordingCancelHotkey } = await load();
  const calls = [];
  const result = await registerRecordingCancelHotkey(async (hotkey) => {
    calls.push(hotkey);
    return { success: true };
  }, "Control+Shift+X");

  assert.deepEqual(calls, ["Control+Shift+X"]);
  assert.deepEqual(result, {
    success: true,
    activeHotkey: "Control+Shift+X",
    usedFallback: false,
  });
});

test("falls back to Escape when a custom cancel hotkey is rejected", async () => {
  const { registerRecordingCancelHotkey } = await load();
  const calls = [];
  const result = await registerRecordingCancelHotkey(async (hotkey) => {
    calls.push(hotkey);
    return { success: hotkey === "Escape" };
  }, "Control+Shift+X");

  assert.deepEqual(calls, ["Control+Shift+X", "Escape"]);
  assert.deepEqual(result, { success: true, activeHotkey: "Escape", usedFallback: true });
});

test("does not retry Escape when the default binding is rejected", async () => {
  const { registerRecordingCancelHotkey } = await load();
  const calls = [];
  const result = await registerRecordingCancelHotkey(async (hotkey) => {
    calls.push(hotkey);
    return { success: false };
  }, "Escape");

  assert.deepEqual(calls, ["Escape"]);
  assert.deepEqual(result, { success: false, activeHotkey: null, usedFallback: false });
});

test("uses Escape for missing or whitespace-only settings", async () => {
  const { registerRecordingCancelHotkey } = await load();
  const calls = [];
  const result = await registerRecordingCancelHotkey(async (hotkey) => {
    calls.push(hotkey);
    return { success: true };
  }, "   ");

  assert.deepEqual(calls, ["Escape"]);
  assert.equal(result.activeHotkey, "Escape");
});

test("uses Escape for cancel hotkeys that lack a cancel-slot listener", async () => {
  const { registerRecordingCancelHotkey } = await load();
  const calls = [];

  await registerRecordingCancelHotkey(async (hotkey) => {
    calls.push(hotkey);
    return { success: true };
  }, "GLOBE");

  assert.deepEqual(calls, ["Escape"]);
});

test("identifies cancel hotkeys that require a dedicated native listener", async () => {
  const { isUnsupportedRecordingCancelHotkey } = await load();

  for (const hotkey of [
    "GLOBE",
    "Fn",
    "Fn+F8",
    "MouseButton4",
    "MouseButton10",
    "RightControl",
    "RightOption",
  ]) {
    assert.equal(isUnsupportedRecordingCancelHotkey(hotkey), true, hotkey);
  }
  for (const hotkey of ["Escape", "Control+X", "F8"]) {
    assert.equal(isUnsupportedRecordingCancelHotkey(hotkey), false, hotkey);
  }
});

test("falls back after a custom registration throws", async () => {
  const { registerRecordingCancelHotkey } = await load();
  const calls = [];
  const result = await registerRecordingCancelHotkey(async (hotkey) => {
    calls.push(hotkey);
    if (hotkey !== "Escape") throw new Error("registration failed");
    return { success: true };
  }, "Alt+X");

  assert.deepEqual(calls, ["Alt+X", "Escape"]);
  assert.deepEqual(result, { success: true, activeHotkey: "Escape", usedFallback: true });
});
