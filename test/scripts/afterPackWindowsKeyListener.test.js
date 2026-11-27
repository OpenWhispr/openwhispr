const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const { verifyWindowsKeyListener } = require("../../scripts/afterPack");

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useHost(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
}

test("checks the exact-modifier protocol of the packaged Windows key listener", (t) => {
  const dir = makeBinDir(t);
  const listener = path.join(dir, "windows-key-listener.exe");
  fs.writeFileSync(listener, "");
  useHost(t, "win32");
  const probe = t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: "EXACT_MODIFIERS_READY\r\n",
  }));

  verifyWindowsKeyListener(dir);

  assert.equal(probe.mock.callCount(), 1);
  assert.deepEqual(probe.mock.calls[0].arguments.slice(0, 2), [
    listener,
    ["--supports-exact-modifiers"],
  ]);
});

test("checks presence without running a Windows executable on another host", (t) => {
  const dir = makeBinDir(t);
  fs.writeFileSync(path.join(dir, "windows-key-listener.exe"), "");
  useHost(t, "linux");
  const probe = t.mock.method(childProcess, "spawnSync");

  verifyWindowsKeyListener(dir);

  assert.equal(probe.mock.callCount(), 0);
});

for (const [problem, reply] of [
  ["legacy helper", { status: 0, stdout: "READY\n" }],
  ["failed probe", { status: 1, stdout: "EXACT_MODIFIERS_READY\n" }],
  ["unrunnable helper", { status: null, error: new Error("ETIMEDOUT") }],
]) {
  test(`rejects a bundled Windows key listener with a ${problem}`, (t) => {
    const dir = makeBinDir(t);
    fs.writeFileSync(path.join(dir, "windows-key-listener.exe"), "");
    useHost(t, "win32");
    t.mock.method(childProcess, "spawnSync", () => reply);

    assert.throws(() => verifyWindowsKeyListener(dir), /does not support exact modifier matching/);
  });
}

test("fails when the Windows key listener is missing", (t) => {
  const dir = makeBinDir(t);
  assert.throws(() => verifyWindowsKeyListener(dir), /missing .*windows-key-listener\.exe/);
});
