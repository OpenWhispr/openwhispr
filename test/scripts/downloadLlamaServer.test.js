const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildMachOImage } = require("../helpers/harness/machoFixture");
const { MACOS_DEPLOYMENT_TARGET, assertRunsOnMacOS } = require("../../scripts/download-llama-server");

function writeImages(t, minimums) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-macho-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return minimums.map((minos, index) => {
    const file = path.join(dir, `lib${index}.dylib`);
    fs.writeFileSync(file, buildMachOImage({ minos }));
    return file;
  });
}

test("accepts builds that run on the deployment target or older", (t) => {
  assert.doesNotThrow(() => assertRunsOnMacOS(writeImages(t, [MACOS_DEPLOYMENT_TARGET, "11.0"])));
});

test("refuses a build for macOS 26, naming the file and the version it needs (#2943)", (t) => {
  const files = writeImages(t, ["13.3", "26.0"]);
  assert.throws(() => assertRunsOnMacOS(files), /lib1\.dylib needs macOS 26\.0/);
});

test("compares versions numerically, not as strings", (t) => {
  assert.throws(() => assertRunsOnMacOS(writeImages(t, ["13.10"])), /needs macOS 13\.10/);
  assert.throws(() => assertRunsOnMacOS(writeImages(t, ["13.3.1"])), /needs macOS 13\.3\.1/);
  assert.doesNotThrow(() => assertRunsOnMacOS(writeImages(t, ["9.0"])));
});
