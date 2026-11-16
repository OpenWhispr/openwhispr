const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMachOImage } = require("../helpers/harness/machoFixture");
const { readMinimumMacOS } = require("../../scripts/lib/macho-build-version");

test("reads the minimum macOS from LC_BUILD_VERSION, past the commands before it", () => {
  assert.equal(readMinimumMacOS(buildMachOImage({ minos: "26.0" })), "26.0");
  assert.equal(readMinimumMacOS(buildMachOImage({ minos: "13.3" })), "13.3");
});

test("shows the patch component only when it is set, as otool does", () => {
  assert.equal(readMinimumMacOS(buildMachOImage({ minos: "10.15.4" })), "10.15.4");
});

test("rejects a buffer that is not a thin 64-bit Mach-O", () => {
  assert.throws(() => readMinimumMacOS(Buffer.from("not a mach-o image at all, padded")), /Mach-O/);
});

test("rejects an image without LC_BUILD_VERSION", () => {
  assert.throws(() => readMinimumMacOS(buildMachOImage({ minos: null })), /LC_BUILD_VERSION/);
});
