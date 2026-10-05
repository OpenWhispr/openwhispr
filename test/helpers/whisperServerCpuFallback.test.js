const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { installElectronStub, setUserDataDir } = require("./harness/electronStub");

// getServerBinaryPath's GPU branch and sidecarPidFile read app.getPath("userData").
// Each install below points it at its own temp dir, so no pid file lands in the repo.
installElectronStub();

const WhisperServerManager = require("../../src/helpers/whisperServer");
const { isIllegalInstructionExit } = WhisperServerManager;
const { BIN_SUBDIR: CUDA_BIN_SUBDIR } = require("../../src/helpers/whisperCudaManager");
const { BIN_SUBDIR: VULKAN_BIN_SUBDIR } = require("../../src/helpers/whisperVulkanManager");
const { cpuFallbackServerBinaryName } = require("../../src/helpers/whisperCppRelease");

const PRIMARY = `whisper-server-${process.platform}-${process.arch}`;
const IVYBRIDGE = cpuFallbackServerBinaryName(process.platform, process.arch, "ivybridge");
const SANDYBRIDGE = cpuFallbackServerBinaryName(process.platform, process.arch, "sandybridge");
const CUDA = `whisper-server-${process.platform}-${process.arch}-cuda`;
const VULKAN = `whisper-server-${process.platform}-${process.arch}-vulkan`;

// The fake builds are POSIX shell scripts. CI runs this suite on Linux; the
// Windows exit code is covered by the isIllegalInstructionExit test.
// A timeout turns a relaunch loop into a failure instead of a hung CI job.
const SPAWNS_FAKE_BUILDS = {
  skip: process.platform === "win32" && "the fake whisper-server builds are shell scripts",
  timeout: 30000,
};

// An OS-assigned port per start. A fake that dies never binds its port, so with
// the manager's fixed range another run of this file (a second worktree) could
// answer the health check on it.
function osAssignedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A temp install: fake whisper-server builds in <dir>/bin, found through
// process.resourcesPath like a packaged app, and GPU packs under <dir>/userData.
// Each fake appends its file name to spawns.log, then either dies of a signal
// ("sigill" is how a build dies on a processor that lacks its instructions) or
// serves HTTP like a started server. On macOS each signal death also leaves a
// crash report in ~/Library/Logs/DiagnosticReports.
function createInstall(t, builds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-cpu-fallback-"));
  const spawnLog = path.join(dir, "spawns.log");
  const serverScript = path.join(dir, "fake-server.js");
  fs.writeFileSync(
    serverScript,
    `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("http")
  .createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "ok" }));
  })
  .listen(port, "127.0.0.1");
`
  );
  const dirs = {
    [PRIMARY]: path.join(dir, "bin"),
    [IVYBRIDGE]: path.join(dir, "bin"),
    [SANDYBRIDGE]: path.join(dir, "bin"),
    [CUDA]: path.join(dir, "userData", "bin", CUDA_BIN_SUBDIR),
    [VULKAN]: path.join(dir, "userData", "bin", VULKAN_BIN_SUBDIR),
  };
  const runs = {
    sigill: "kill -s ILL $$",
    sigsegv: "kill -s SEGV $$",
    serve: `exec '${process.execPath}' '${serverScript}' "$@"`,
  };
  for (const [name, behavior] of Object.entries(builds)) {
    fs.mkdirSync(dirs[name], { recursive: true });
    fs.writeFileSync(
      path.join(dirs[name], name),
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${spawnLog}'\n${runs[behavior]}\n`,
      { mode: 0o755 }
    );
  }
  const model = path.join(dir, "ggml-test.bin");
  fs.writeFileSync(model, "not a real model");

  const previousResourcesPath = process.resourcesPath;
  process.resourcesPath = dir;
  setUserDataDir(path.join(dir, "userData"));
  const manager = new WhisperServerManager();
  manager.findAvailablePort = osAssignedPort;
  t.after(async () => {
    await manager.stop();
    process.resourcesPath = previousResourcesPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    manager,
    model,
    binaryPath: (name) => path.join(dirs[name], name),
    spawns: () =>
      fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean) : [],
  };
}

// A Unix signal death reports no exit code, so a whisper-server killed by SIGILL
// at startup used to fail with no detail at all (#2356).
test("a startup death names the signal when the server printed nothing", async () => {
  const manager = new WhisperServerManager();

  await assert.rejects(
    manager.waitForReady(() => ({ stderr: "", exitCode: null, signal: "SIGSEGV" }), 1000),
    { message: "whisper-server process died during startup: signal: SIGSEGV" }
  );
  await assert.rejects(
    manager.waitForReady(() => ({ stderr: "", exitCode: 3221225501, signal: null }), 1000),
    { message: "whisper-server process died during startup: exit code: 3221225501" }
  );
  await assert.rejects(
    manager.waitForReady(
      () => ({ stderr: "ggml_abort\n", exitCode: null, signal: "SIGABRT" }),
      1000
    ),
    { message: "whisper-server process died during startup: ggml_abort" }
  );
});

test("isIllegalInstructionExit recognises the Windows and Unix illegal-instruction exits only", () => {
  // How Node reports STATUS_ILLEGAL_INSTRUCTION (0xC000001D) on Windows
  assert.equal(isIllegalInstructionExit({ exitCode: 3221225501, signal: null }), true);
  // The same NTSTATUS read as a signed 32-bit value (cmd's %ERRORLEVEL%)
  assert.equal(isIllegalInstructionExit({ exitCode: -1073741795, signal: null }), true);
  assert.equal(isIllegalInstructionExit({ exitCode: null, signal: "SIGILL" }), true);

  assert.equal(isIllegalInstructionExit({ exitCode: 3221225477, signal: null }), false); // access violation
  assert.equal(isIllegalInstructionExit({ exitCode: 1, signal: null }), false);
  assert.equal(isIllegalInstructionExit({ exitCode: 132, signal: null }), false); // a shell's 128 + 4
  assert.equal(isIllegalInstructionExit({ exitCode: null, signal: "SIGSEGV" }), false);
  assert.equal(isIllegalInstructionExit({ exitCode: null, signal: null }), false); // still running
  assert.equal(isIllegalInstructionExit({}), false);
});

test("the builds for processors without AVX2 are named like the platform's executables", () => {
  assert.equal(
    cpuFallbackServerBinaryName("win32", "x64", "ivybridge"),
    "whisper-server-win32-x64-ivybridge.exe"
  );
  assert.equal(
    cpuFallbackServerBinaryName("linux", "x64", "sandybridge"),
    "whisper-server-linux-x64-sandybridge"
  );
});

test(
  "an Ivy Bridge-class processor: the primary dies of SIGILL and the ivybridge build takes over",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    const install = createInstall(t, {
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "serve",
      [SANDYBRIDGE]: "serve",
    });

    await install.manager.start(install.model, { threads: 4 });

    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE]);
    assert.equal(install.manager.getStatus().running, true);
    assert.equal(install.manager.getServerBinaryPath(), install.binaryPath(IVYBRIDGE));
  }
);

test(
  "a Sandy Bridge-class processor: each build that dies hands over to the next level",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    const install = createInstall(t, {
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "sigill",
      [SANDYBRIDGE]: "serve",
    });

    await install.manager.start(install.model, { threads: 4 });

    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, SANDYBRIDGE]);
    assert.equal(install.manager.getServerBinaryPath(), install.binaryPath(SANDYBRIDGE));
  }
);

test("a level that is not installed is skipped", SPAWNS_FAKE_BUILDS, async (t) => {
  const install = createInstall(t, { [PRIMARY]: "sigill", [SANDYBRIDGE]: "serve" });

  await install.manager.start(install.model, { threads: 4 });

  assert.deepEqual(install.spawns(), [PRIMARY, SANDYBRIDGE]);
});

test(
  "with no build for older processors installed, the crash is reported once and the thread retry is skipped",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    // 8 logical CPUs resolve to 6 auto threads: the case that used to relaunch
    // the same crashing build with the default thread count
    t.mock.method(os, "availableParallelism", () => 8);
    const install = createInstall(t, { [PRIMARY]: "sigill" });

    await assert.rejects(install.manager.start(install.model), (err) => {
      assert.match(err.message, /^whisper-server can't run on this processor: /);
      assert.match(err.message, new RegExp(`${PRIMARY} stopped on an instruction`));
      assert.match(err.message, /\(signal: SIGILL\)/);
      // ipcHandlers' transcribe-local-whisper maps these substrings to other errors
      assert.doesNotMatch(err.message, /whisper-cpp|FFmpeg|not downloaded|Audio buffer is empty/);
      return true;
    });
    assert.deepEqual(install.spawns(), [PRIMARY]);
  }
);

test(
  "when every build dies, each is launched once and later starts go straight to the last one",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    const install = createInstall(t, {
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "sigill",
      [SANDYBRIDGE]: "sigill",
    });

    await assert.rejects(install.manager.start(install.model, { threads: 4 }), (err) => {
      assert.match(err.message, new RegExp(`${SANDYBRIDGE} stopped on an instruction`));
      return true;
    });
    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, SANDYBRIDGE]);

    await assert.rejects(
      install.manager.start(install.model, { threads: 4 }),
      /can't run on this processor/
    );
    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, SANDYBRIDGE, SANDYBRIDGE]);
  }
);

test(
  "the switch outlives stop(): a later start never re-runs the build that crashed",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    const install = createInstall(t, { [PRIMARY]: "sigill", [IVYBRIDGE]: "serve" });

    await install.manager.start(install.model, { threads: 4 });
    await install.manager.stop();
    await install.manager.start(install.model, { threads: 4 });

    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, IVYBRIDGE]);
  }
);

test(
  "a CUDA pack on such a processor falls back to CPU, then down to the build that runs (#1613)",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    const install = createInstall(t, {
      [CUDA]: "sigill",
      [VULKAN]: "serve",
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "serve",
    });
    const fallbacks = [];
    install.manager.on("cuda-fallback", () => fallbacks.push("cuda"));

    await install.manager.start(install.model, { useCuda: true, threads: 4 });

    assert.deepEqual(install.spawns(), [CUDA, PRIMARY, IVYBRIDGE]);
    assert.deepEqual(fallbacks, ["cuda"]);
    assert.equal(install.manager.getStatus().gpuBackend, null);

    // WHISPER_GPU_FAILED=cuda lets the next dictation resolve to the installed
    // Vulkan pack: the session keeps its working CPU server instead of a GPU cold start
    await install.manager.start(install.model, { useVulkan: true, threads: 4 });
    assert.deepEqual(install.spawns(), [CUDA, PRIMARY, IVYBRIDGE]);
  }
);

test(
  "any other startup crash fails as before and keeps the primary build",
  SPAWNS_FAKE_BUILDS,
  async (t) => {
    const install = createInstall(t, { [PRIMARY]: "sigsegv", [IVYBRIDGE]: "serve" });

    await assert.rejects(install.manager.start(install.model, { threads: 4 }), {
      message: "whisper-server process died during startup: signal: SIGSEGV",
    });
    assert.deepEqual(install.spawns(), [PRIMARY]);
    assert.equal(install.manager.getServerBinaryPath(), install.binaryPath(PRIMARY));
  }
);

test("two starts racing through the switch share one fallback", SPAWNS_FAKE_BUILDS, async (t) => {
  const install = createInstall(t, { [PRIMARY]: "sigill", [IVYBRIDGE]: "serve" });

  // Launch pre-warm and the first dictation arrive together
  await Promise.all([
    install.manager.start(install.model, { threads: 4 }),
    install.manager.start(install.model, { threads: 4 }),
  ]);

  assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE]);
});
