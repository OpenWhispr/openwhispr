const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  detectNvidiaGpu,
  listNvidiaGpus,
  resolveNvidiaSmiPath,
  clearCache,
} = require("../../src/utils/gpuDetection.js");

// The ladder's System32/DriverStore/WMI rungs are win32-only; pin the platform
// the way gpuBinaryManager.test.js does. Each test file runs in its own
// process, but restore anyway.
const realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32" });
test.after(() => Object.defineProperty(process, "platform", { value: realPlatform }));
test.beforeEach(() => clearCache());

const SYSTEM32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const SYSTEM32_SMI = path.join(SYSTEM32, "nvidia-smi.exe");
const REPOSITORY = path.join(SYSTEM32, "DriverStore", "FileRepository");

const RTX_ROW = "NVIDIA GeForce RTX 4060 Ti, 555.85, 16380, 8.9\n";

function enoent(command) {
  const error = new Error(`spawn ${command} ENOENT`);
  error.code = "ENOENT";
  return error;
}

// handlers: (file, args) => { error?, stdout? }; every call is recorded
function fakeExecFile(handlers, calls = []) {
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const result = handlers(file, args) || {};
    process.nextTick(() => callback(result.error || null, result.stdout || ""));
  };
  impl.calls = calls;
  return impl;
}

function fakeFs({ existing = [], driverStoreDirs = null, mtimes = {} } = {}) {
  return {
    existsSync: (p) => existing.includes(p),
    readdirSync: (p) => {
      if (p === REPOSITORY && driverStoreDirs) return driverStoreDirs;
      throw enoent(p);
    },
    statSync: (p) => ({ mtimeMs: mtimes[p] || 0 }),
  };
}

test("nvidia-smi on PATH wins the ladder and answers detection", async () => {
  const execFileImpl = fakeExecFile((file) => {
    assert.equal(file, "nvidia-smi");
    return { stdout: RTX_ROW };
  });

  const info = await detectNvidiaGpu({ execFileImpl, fsImpl: fakeFs() });
  assert.equal(info.hasNvidiaGpu, true);
  assert.equal(info.cudaSupported, true);
  assert.equal(info.gpuName, "NVIDIA GeForce RTX 4060 Ti");
});

test("PATH miss falls back to the System32 copy", async () => {
  const execFileImpl = fakeExecFile((file) =>
    file === "nvidia-smi" ? { error: enoent("nvidia-smi") } : { stdout: RTX_ROW }
  );

  const resolved = await resolveNvidiaSmiPath({
    execFileImpl,
    fsImpl: fakeFs({ existing: [SYSTEM32_SMI] }),
  });
  assert.deepEqual(resolved, { smiPath: SYSTEM32_SMI, source: "system32" });
});

test("System32 miss falls back to the newest DriverStore copy", async () => {
  const older = path.join(REPOSITORY, "nvmdi.inf_amd64_111", "nvidia-smi.exe");
  const newer = path.join(REPOSITORY, "nvmdi.inf_amd64_222", "nvidia-smi.exe");
  const execFileImpl = fakeExecFile((file) =>
    file === "nvidia-smi" ? { error: enoent("nvidia-smi") } : { stdout: RTX_ROW }
  );

  const resolved = await resolveNvidiaSmiPath({
    execFileImpl,
    fsImpl: fakeFs({
      existing: [older, newer],
      driverStoreDirs: ["nvmdi.inf_amd64_111", "nvmdi.inf_amd64_222", "intelgpu.inf_amd64_1"],
      mtimes: { [older]: 1000, [newer]: 2000 },
    }),
  });
  assert.deepEqual(resolved, { smiPath: newer, source: "driverstore" });
});

test("with no nvidia-smi anywhere, WMI still detects the NVIDIA GPU", async () => {
  const execFileImpl = fakeExecFile((file) => {
    if (file === "nvidia-smi") return { error: enoent("nvidia-smi") };
    assert.equal(file, "powershell.exe");
    return { stdout: "AMD Radeon RX 7900 XTX\r\nNVIDIA GeForce RTX 4060 Ti\r\nIntel(R) UHD Graphics 770\r\n" };
  });

  const info = await detectNvidiaGpu({ execFileImpl, fsImpl: fakeFs() });
  assert.deepEqual(info, {
    hasNvidiaGpu: true,
    gpuName: "NVIDIA GeForce RTX 4060 Ti",
    cudaSupported: true,
    detectionSource: "wmi",
  });
});

test("when every rung misses there is no NVIDIA GPU", async () => {
  const execFileImpl = fakeExecFile((file) =>
    file === "nvidia-smi"
      ? { error: enoent("nvidia-smi") }
      : { stdout: "Intel(R) UHD Graphics 770\r\n" }
  );

  const info = await detectNvidiaGpu({ execFileImpl, fsImpl: fakeFs() });
  assert.deepEqual(info, { hasNvidiaGpu: false });
});

test("detection results and the resolved path are cached", async () => {
  const execFileImpl = fakeExecFile(() => ({ stdout: RTX_ROW }));

  await detectNvidiaGpu({ execFileImpl, fsImpl: fakeFs() });
  const callsAfterFirst = execFileImpl.calls.length;
  const again = await detectNvidiaGpu({ execFileImpl, fsImpl: fakeFs() });

  assert.equal(again.hasNvidiaGpu, true);
  assert.equal(execFileImpl.calls.length, callsAfterFirst);
});

test("listNvidiaGpus uses the resolved path and stays empty on WMI-only machines", async () => {
  const withSmi = fakeExecFile((file) =>
    file === "nvidia-smi"
      ? { stdout: "0, GPU-abc123, NVIDIA GeForce RTX 4060 Ti, 16380\n" }
      : {}
  );
  const gpus = await listNvidiaGpus({ execFileImpl: withSmi, fsImpl: fakeFs() });
  assert.deepEqual(gpus, [
    { index: 0, uuid: "GPU-abc123", name: "NVIDIA GeForce RTX 4060 Ti", vramMb: 16380 },
  ]);

  clearCache();
  const withoutSmi = fakeExecFile((file) =>
    file === "nvidia-smi" ? { error: enoent("nvidia-smi") } : { stdout: "NVIDIA GeForce RTX 4060 Ti\r\n" }
  );
  assert.deepEqual(await listNvidiaGpus({ execFileImpl: withoutSmi, fsImpl: fakeFs() }), []);
});
