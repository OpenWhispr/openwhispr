const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verifyWindowsKeyListener } = require("../../scripts/afterPack");

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("passes when the Windows key listener is bundled", (t) => {
  const dir = makeBinDir(t);
  fs.writeFileSync(path.join(dir, "windows-key-listener.exe"), "");
  assert.doesNotThrow(() => verifyWindowsKeyListener(dir));
});

test("fails when the Windows key listener is missing", (t) => {
  const dir = makeBinDir(t);
  assert.throws(() => verifyWindowsKeyListener(dir), /missing .*windows-key-listener\.exe/);
});
