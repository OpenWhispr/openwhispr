const test = require("node:test");
const assert = require("node:assert/strict");

const { getQualcommCapability, getQualcommNpuCapability } = require(
  "../../src/helpers/qualcommCapability"
);
const { resetQualcommCpuCache } = require("../../src/utils/qualcommCpu");

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

function execFileImplReturning(stdout, error = null) {
  return (cmd, args, opts, cb) => {
    assert.equal(cmd, "powershell.exe");
    assert.ok(opts.windowsHide, "WMI spawn must set windowsHide");
    setImmediate(() => cb(error, stdout));
  };
}

test("the full NPU gate passes only on Windows ARM64 with a Snapdragon CPU", async () => {
  resetQualcommCpuCache();
  const pass = await getQualcommNpuCapability({
    platform: "win32",
    arch: "arm64",
    execFileImpl: execFileImplReturning(
      "Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Technologies, Inc."
    ),
  });
  assert.equal(pass.supported, true);
  assert.equal(pass.reason, null);
  assert.match(pass.cpuName, /X1E78100/);
});

test("the full NPU gate rejects an ARM64 CPU that is not Qualcomm's", async () => {
  resetQualcommCpuCache();
  const miss = await getQualcommNpuCapability({
    platform: "win32",
    arch: "arm64",
    execFileImpl: execFileImplReturning("SomeOther Vendor ARM64 CPU"),
  });
  assert.equal(miss.supported, false);
  assert.equal(miss.code, "QUALCOMM_CPU_NOT_DETECTED");
  assert.equal(miss.reason, "cpu");
  assert.match(miss.message, /Snapdragon/);
});

test("the full NPU gate reports the platform reason before any CPU query matters", async () => {
  resetQualcommCpuCache();
  const platformMiss = await getQualcommNpuCapability({
    platform: "win32",
    arch: "x64",
    envOverride: "1", // even a forced-yes CPU answer cannot rescue the platform
  });
  assert.equal(platformMiss.supported, false);
  assert.equal(platformMiss.code, "QUALCOMM_UNSUPPORTED_PLATFORM");
  assert.equal(platformMiss.reason, "platform");
  resetQualcommCpuCache();
});
