const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectQualcommCpu,
  isQualcommCpuName,
  resetQualcommCpuCache,
} = require("../../src/utils/qualcommCpu");

// Fake execFile that answers the WMI processor-name query with a fixed line.
function execFileImplReturning(stdout, error = null) {
  return (cmd, args, opts, cb) => {
    if (cmd !== "powershell.exe") throw new Error(`unexpected command: ${cmd}`);
    assert.ok(opts.windowsHide, "WMI spawn must set windowsHide");
    setImmediate(() => cb(error, stdout));
  };
}

test("CPU name matching recognises Qualcomm's shipped names", () => {
  assert.equal(
    isQualcommCpuName("Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Technologies, Inc."),
    true
  );
  assert.equal(
    isQualcommCpuName("Qualcomm(R) Snapdragon(R) 8 Elite"),
    true
  );
  assert.equal(isQualcommCpuName("AMD Ryzen 9 7950X"), false);
  assert.equal(isQualcommCpuName("Apple M4 Pro"), false);
  assert.equal(isQualcommCpuName(""), false);
  assert.equal(isQualcommCpuName(null), false);
});

test("non-ARM64 or non-Windows platforms skip the WMI query entirely", async () => {
  resetQualcommCpuCache();
  const x64 = await detectQualcommCpu({
    platform: "win32",
    arch: "x64",
    execFileImpl: execFileImplReturning("Snapdragon X Elite"),
  });
  assert.equal(x64.qualcommCpu, false);

  resetQualcommCpuCache();
  const mac = await detectQualcommCpu({
    platform: "darwin",
    arch: "arm64",
    execFileImpl: execFileImplReturning("Apple M4 Pro"),
  });
  assert.equal(mac.qualcommCpu, false);
});

test("a Snapdragon CPU name on Windows ARM64 qualifies", async () => {
  resetQualcommCpuCache();
  const hit = await detectQualcommCpu({
    platform: "win32",
    arch: "arm64",
    execFileImpl: execFileImplReturning(
      "Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Technologies, Inc."
    ),
  });
  assert.equal(hit.qualcommCpu, true);
  assert.match(hit.cpuName, /X1E78100/);
});

test("an ARM64 CPU from another vendor does not qualify", async () => {
  resetQualcommCpuCache();
  const miss = await detectQualcommCpu({
    platform: "win32",
    arch: "arm64",
    execFileImpl: execFileImplReturning("SomeOther ARM64 CPU"),
  });
  assert.equal(miss.qualcommCpu, false);
});

test("a failed WMI query answers no rather than guessing", async () => {
  resetQualcommCpuCache();
  const failed = await detectQualcommCpu({
    platform: "win32",
    arch: "arm64",
    execFileImpl: execFileImplReturning("", new Error("cim unavailable")),
  });
  assert.equal(failed.qualcommCpu, false);
});

test("the explicit override wins and skips the WMI query", async () => {
  resetQualcommCpuCache();
  const forced = await detectQualcommCpu({
    platform: "win32",
    arch: "arm64",
    envOverride: "1",
    execFileImpl: () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(forced.qualcommCpu, true);

  resetQualcommCpuCache();
  const denied = await detectQualcommCpu({
    platform: "win32",
    arch: "arm64",
    envOverride: "0",
    execFileImpl: () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(denied.qualcommCpu, false);
  resetQualcommCpuCache();
});
