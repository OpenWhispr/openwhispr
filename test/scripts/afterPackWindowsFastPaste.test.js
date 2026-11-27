const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verifyWindowsFastPaste } = require("../../scripts/afterPack");

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("passes when the Windows fast-paste helper is bundled", (t) => {
  const dir = makeBinDir(t);
  fs.writeFileSync(path.join(dir, "windows-fast-paste.exe"), "");
  assert.doesNotThrow(() => verifyWindowsFastPaste(dir));
});

test("fails when the Windows fast-paste helper is missing", (t) => {
  const dir = makeBinDir(t);
  assert.throws(() => verifyWindowsFastPaste(dir), /missing .*windows-fast-paste\.exe/);
});
