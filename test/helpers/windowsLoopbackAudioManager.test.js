const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/windowsLoopbackAudioManager");
const originalLoad = Module._load;
const originalPlatform = process.platform;

const loggedWarnings = [];

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

function loadManagerClass() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return {
        info() {},
        debug() {},
        error() {},
        warn(message, context) {
          loggedWarnings.push({ message, context });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const WindowsLoopbackAudioManager = loadManagerClass();

// Probes run through instance seams (resolveBinary decides whether the helper
// exists; _runJsonCommand talks to it), so the cache/TTL/force logic under
// test is exercised without spawning anything.
function createManager({ binary = "C:\\helper.exe", probe } = {}) {
  const manager = new WindowsLoopbackAudioManager();
  manager.resolveBinary = typeof binary === "function" ? binary : () => binary;
  let probeCalls = 0;
  manager._runJsonCommand = async (...args) => {
    probeCalls += 1;
    return probe(probeCalls, ...args);
  };
  manager.probeCalls = () => probeCalls;
  return manager;
}

const NATIVE_OK = { ok: true, supportsSystemAudio: true, supportsNativeCapture: true };

test("force refresh recovers from a stale unavailable probe (#1471)", async () => {
  setPlatform("win32");
  let binaryPresent = false;
  const manager = createManager({
    binary: () => (binaryPresent ? "C:\\helper.exe" : null),
    probe: async () => NATIVE_OK,
  });

  // An early probe before the packaged binary is reachable caches unavailable.
  assert.equal((await manager.getCapability()).available, false);

  // Meeting start forces a re-probe instead of trusting the stale result.
  binaryPresent = true;
  assert.equal((await manager.getCapability({ force: true })).available, true);

  // The refreshed result replaces the cache for subsequent readers.
  assert.equal((await manager.getCapability()).available, true);
  assert.equal(manager.probeCalls(), 1);
});

test("binary-missing failure expires after the transient TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setPlatform("win32");
  let binaryPresent = false;
  const manager = createManager({
    binary: () => (binaryPresent ? "C:\\helper.exe" : null),
    probe: async () => NATIVE_OK,
  });

  assert.equal((await manager.getCapability()).available, false);

  // Inside the TTL the cached failure is served even after the binary appears.
  binaryPresent = true;
  assert.equal((await manager.getCapability()).available, false);

  t.mock.timers.tick(30_001);
  assert.equal((await manager.getCapability()).available, true);
});

test("a successful probe is cached for the whole session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setPlatform("win32");
  const manager = createManager({ probe: async () => NATIVE_OK });

  assert.equal((await manager.getCapability()).available, true);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal((await manager.getCapability()).available, true);
  assert.equal(manager.probeCalls(), 1);
});

test("a definitive unsupported result is cached for the whole session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setPlatform("win32");
  const manager = createManager({
    probe: async () => ({
      ok: false,
      supportsSystemAudio: false,
      supportsNativeCapture: false,
      error: "Process loopback requires Windows 10 2004 or newer.",
    }),
  });

  assert.equal((await manager.getCapability()).available, false);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal((await manager.getCapability()).available, false);
  assert.equal(manager.probeCalls(), 1);
});

test("an activation timeout is retried after the transient TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setPlatform("win32");
  const manager = createManager({
    probe: async (call) =>
      call === 1 ? { ok: false, error: "activation_timeout waiting for audio client" } : NATIVE_OK,
  });

  assert.equal((await manager.getCapability()).available, false);
  t.mock.timers.tick(30_001);
  assert.equal((await manager.getCapability()).available, true);
  assert.equal(manager.probeCalls(), 2);
});

test("a probe spawn failure is logged and retried after the transient TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setPlatform("win32");
  loggedWarnings.length = 0;
  const manager = createManager({
    probe: async (call) => {
      if (call === 1) throw new Error("spawn EACCES");
      return NATIVE_OK;
    },
  });

  const capability = await manager.getCapability();
  assert.equal(capability.available, false);
  assert.equal(capability.error, "spawn EACCES");
  assert.equal(loggedWarnings.length, 1);

  t.mock.timers.tick(30_001);
  assert.equal((await manager.getCapability()).available, true);
});

test("a probe that reports ok without native capture support is unavailable", async () => {
  setPlatform("win32");
  const manager = createManager({
    probe: async () => ({ ok: true, supportsSystemAudio: true }),
  });

  const capability = await manager.getCapability();
  assert.equal(capability.available, false);
  assert.equal(capability.supportsNativeCapture, false);
});

test("concurrent capability checks share one in-flight probe", async () => {
  setPlatform("win32");
  const manager = createManager({
    probe: () => new Promise((resolve) => setImmediate(() => resolve(NATIVE_OK))),
  });

  const [first, second] = await Promise.all([manager.getCapability(), manager.getCapability()]);
  assert.equal(first.available, true);
  assert.equal(second.available, true);
  assert.equal(manager.probeCalls(), 1);
});

test("non-Windows platforms never probe", async () => {
  setPlatform("darwin");
  const manager = createManager({ probe: async () => NATIVE_OK });

  const capability = await manager.getCapability();
  assert.equal(capability.available, false);
  assert.equal(capability.error, "Not running on Windows.");
  assert.equal(manager.probeCalls(), 0);
});

test("live helper probe succeeds on this machine when the binary is present", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only probe");
    return;
  }

  const binaryPath = path.join(
    __dirname,
    "..",
    "..",
    "resources",
    "bin",
    "windows-system-audio-helper.exe"
  );
  if (!fs.existsSync(binaryPath)) {
    t.skip("windows-system-audio-helper.exe is not present in this checkout");
    return;
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["probe"], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`probe exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });

  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.supportsNativeCapture, true);
});
