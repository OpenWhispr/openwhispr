const test = require("node:test");
const assert = require("node:assert/strict");

const { getQualcommCapability } = require("../../src/helpers/qualcommCapability");

test("Qualcomm NPU transcription requires Windows on Snapdragon", () => {
  assert.deepEqual(getQualcommCapability({ platform: "win32", arch: "arm64" }), {
    supported: true,
  });
});

test("Qualcomm NPU transcription rejects non-Windows platforms", () => {
  for (const platform of ["darwin", "linux"]) {
    const capability = getQualcommCapability({ platform, arch: "arm64" });
    assert.equal(capability.supported, false);
    assert.equal(capability.code, "QUALCOMM_UNSUPPORTED_PLATFORM");
  }
});

test("Qualcomm NPU transcription rejects x64 Windows (emulated Python cannot reach the NPU)", () => {
  const capability = getQualcommCapability({ platform: "win32", arch: "x64" });
  assert.equal(capability.supported, false);
  assert.equal(capability.code, "QUALCOMM_UNSUPPORTED_PLATFORM");
  assert.match(capability.message, /ARM64/);
});
