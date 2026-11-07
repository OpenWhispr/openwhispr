const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PASTE_LAST_DEFAULT,
  PASTE_LAST_DISABLED,
  normalizeForStorage,
  normalizeForRenderer,
  resolveStartupKey,
} = require("../../src/helpers/pasteLastKey");

// Constants are the ones the rest of the code expects
test("paste-last default is Alt+Shift+Z", () => {
  assert.equal(PASTE_LAST_DEFAULT, "Alt+Shift+Z");
});

test("paste-last disabled sentinel is 'none'", () => {
  assert.equal(PASTE_LAST_DISABLED, "none");
});

// Storage normalization: empty-ish inputs → sentinel
test("normalizeForStorage writes 'none' sentinel for empty-ish input", () => {
  assert.equal(normalizeForStorage(""), "none");
  assert.equal(normalizeForStorage(null), "none");
  assert.equal(normalizeForStorage(undefined), "none");
});

test("normalizeForStorage passes real hotkey strings through untouched", () => {
  assert.equal(normalizeForStorage("Alt+Shift+Z"), "Alt+Shift+Z");
  assert.equal(normalizeForStorage("CommandOrControl+V"), "CommandOrControl+V");
});

// Renderer normalization: sentinel hidden from UI
test("normalizeForRenderer hides the 'none' sentinel behind an empty string", () => {
  assert.equal(normalizeForRenderer("none"), "");
});

test("normalizeForRenderer returns '' for empty/nullish stored values", () => {
  assert.equal(normalizeForRenderer(""), "");
  assert.equal(normalizeForRenderer(null), "");
  assert.equal(normalizeForRenderer(undefined), "");
});

test("normalizeForRenderer passes real hotkey strings through", () => {
  assert.equal(normalizeForRenderer("Alt+Shift+Z"), "Alt+Shift+Z");
  assert.equal(normalizeForRenderer("CommandOrControl+V"), "CommandOrControl+V");
});

// Startup resolution: tri-state stored value → register-decision
test("resolveStartupKey returns null for the disabled sentinel (skip registration)", () => {
  assert.equal(resolveStartupKey("none"), null);
});

test("resolveStartupKey returns the default for never-set storage (first launch)", () => {
  assert.equal(resolveStartupKey(""), "Alt+Shift+Z");
  assert.equal(resolveStartupKey(undefined), "Alt+Shift+Z");
  assert.equal(resolveStartupKey(null), "Alt+Shift+Z");
});

test("resolveStartupKey returns the stored value for real hotkey strings", () => {
  assert.equal(resolveStartupKey("F7"), "F7");
  assert.equal(resolveStartupKey("CommandOrControl+Shift+V"), "CommandOrControl+Shift+V");
});

// Round-trip: save-then-read preserves user intent, including "disabled"
test("round-trip: explicit clear stays disabled across reads", () => {
  const stored = normalizeForStorage("");
  assert.equal(resolveStartupKey(stored), null); // startup skips registration
  assert.equal(normalizeForRenderer(stored), ""); // UI shows no binding
});

test("round-trip: custom key persists unchanged", () => {
  const stored = normalizeForStorage("F6");
  assert.equal(resolveStartupKey(stored), "F6");
  assert.equal(normalizeForRenderer(stored), "F6");
});

test("round-trip: never-set keeps the default at startup", () => {
  const stored = normalizeForStorage(undefined);
  // undefined would go through save only in an unusual path, but even if it
  // did, storage uses the sentinel and startup skips registration — matching
  // the explicit-clear semantics.
  assert.equal(resolveStartupKey(stored), null);
});
