const test = require("node:test");
const assert = require("node:assert/strict");

const LinuxKeyManager = require("../../src/helpers/linuxKeyManager.js");

// A right-side modifier hotkey has no globalShortcut fallback, so a missing
// listener binary must be reported — but reconcileNativeKeyListeners() re-arms
// the same keys on every settings save, activation-mode change and hotkey
// capture, and each of those must not produce another toast.
function makeManager() {
  const manager = new LinuxKeyManager();
  manager.isSupported = true;
  manager.resolveListenerBinary = () => null;

  const reports = [];
  manager.on("unavailable", (error) => reports.push(error.message));
  return { manager, reports };
}

test("a missing listener binary is reported once per key set", () => {
  const { manager, reports } = makeManager();

  manager.setKeys(["RightAlt"]);
  manager.setKeys(["RightAlt"]);
  manager.setKeys(["RightAlt"]);

  assert.equal(reports.length, 1);
  assert.match(reports[0], /binary not found/);
});

test("a newly chosen hotkey is reported even after an earlier failure", () => {
  const { manager, reports } = makeManager();

  manager.setKeys(["RightAlt"]);
  manager.setKeys(["RightControl"]);

  assert.equal(reports.length, 2);
});

test("key order does not make the same set look new", () => {
  const { manager, reports } = makeManager();

  manager.setKeys(["RightAlt", "Control+Super"]);
  manager.setKeys(["Control+Super", "RightAlt"]);

  assert.equal(reports.length, 1);
});

test("watching nothing reports nothing", () => {
  const { manager, reports } = makeManager();

  manager.setKeys([]);

  assert.equal(reports.length, 0);
});
